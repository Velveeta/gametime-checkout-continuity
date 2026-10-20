/** Snapshot and commit touch only explicitly supplied, same-slot KEYS. */
export const SNAPSHOT_LUA = String.raw`
local values={}
for i,key in ipairs(KEYS) do values[i]=redis.call('GET',key) or '' end
local t=redis.call('TIME')
return cjson.encode({raw=values,nowMs=tonumber(t[1])*1000+math.floor(tonumber(t[2])/1000)})
`;

/** Optimistic SERIALIZABLE commit: validate every read and the first temporal
 * boundary before publishing the candidate. All encoding/validation precedes one
 * MSET; no preceding writes can survive a later validation/encoding error.
 */
export const COMMIT_LUA = String.raw`
local p=cjson.decode(ARGV[1])
for i,key in ipairs(KEYS) do
  if (redis.call('GET',key) or '')~=p.expected[i] then return cjson.encode({committed=false}) end
end
local t=redis.call('TIME')
local now=tonumber(t[1])*1000+math.floor(tonumber(t[2])/1000)
if now<p.observedAt or (p.validBefore and now>=p.validBefore) then return cjson.encode({committed=false}) end
local idx=p.values[1]
for _,a in ipairs(p.relative) do
  local s=idx.sessions[a.id]
  local inventory=p.values[a.eventKeyIndex]
  local r=inventory.reservations[s.reservationId]
  if a.mode=='CREATE' then
    s.createdAt=now
    s.reservationExpiresAt=now+a.holdMs
    s.recoveryRetainUntil=s.reservationExpiresAt+a.retentionMs
    r.createdAtMs=now
    r.expiresAtMs=s.reservationExpiresAt
  else
    s.processingDeadlineAt=now+a.processingMs
    r.processingDeadlineMs=s.processingDeadlineAt
  end
end
if p.newOrderId then idx.orders[p.newOrderId].createdAt=now end
if p.finalLedgerKey then idx.ledger[p.finalLedgerKey].final.serverNow=now end
local response=p.response
if response.ok and response.value then
  if p.replayLedgerKey then
    response.value=cjson.decode(cjson.encode(idx.ledger[p.replayLedgerKey].final))
    if response.value.kind=='COMPLETED' or response.value.kind=='REPLAY_COMPLETED' then response.value.kind='REPLAY_COMPLETED' else response.value.kind='REPLAY' end
    response.value.events={}
  else
    if response.value.session then response.value.session=idx.sessions[response.value.session.id] end
    response.value.serverNow=now
  end
end
-- Serialize the response and ALL values before the sole write command.
local encodedResponse=cjson.encode({committed=true,response=response})
local writes={}
for i,key in ipairs(KEYS) do
  table.insert(writes,key)
  table.insert(writes,cjson.encode(p.values[i]))
end
redis.call('MSET',unpack(writes))
return encodedResponse
`;
