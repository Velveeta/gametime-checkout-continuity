/** All authoritative reads use primary-routed EVAL and explicit same-slot KEYS. */
export const SNAPSHOT_LUA = String.raw`
local count=#KEYS
if ARGV[1] then
  if (redis.call('GET',KEYS[count]) or 'base')~=ARGV[1] then return cjson.encode({stale=true}) end
  count=count-1
end
local values={}
for i=1,count do local key=KEYS[i] values[i]=redis.call('GET',key) or '' end
local t=redis.call('TIME')
return cjson.encode({raw=values,nowMs=tonumber(t[1])*1000+math.floor(tonumber(t[2])/1000)})
`;

/** Scoped serializable publish. All checks/encoding precede MSET. Absolute TTLs
 * collect temporary coordination records only; they never free inventory.
 */
export const COMMIT_LUA = String.raw`
local p=cjson.decode(ARGV[1])
local count=#KEYS
if p.generation then
  if (redis.call('GET',KEYS[count]) or 'base')~=p.generation then return cjson.encode({stale=true}) end
  count=count-1
end
for i=1,count do local key=KEYS[i]
  if (redis.call('GET',key) or '')~=p.expected[i] then return cjson.encode({committed=false}) end
end
local t=redis.call('TIME')
local now=tonumber(t[1])*1000+math.floor(tonumber(t[2])/1000)
if now<p.observedAt or (p.validBefore and now>=p.validBefore) then return cjson.encode({committed=false}) end
for _,a in ipairs(p.relative) do
  local s=p.values[a.sessionKeyIndex].session
  local r=p.values[a.inventoryKeyIndex].reservations[s.reservationId]
  if a.mode=='CREATE' then
    s.createdAt=now
    s.reservationExpiresAt=now+a.holdMs
    s.recoveryRetainUntil=s.reservationExpiresAt+a.retentionMs
    r.createdAtMs=now
    r.expiresAtMs=s.reservationExpiresAt
  elseif a.mode=='DEADLINE' then
    s.reservationExpiresAt=now+a.holdMs
    s.recoveryRetainUntil=s.reservationExpiresAt+a.retentionMs
    r.expiresAtMs=s.reservationExpiresAt
  else
    s.processingDeadlineAt=now+a.processingMs
    r.processingDeadlineMs=s.processingDeadlineAt
  end
end
if p.orderKeyIndex then p.values[p.orderKeyIndex].order.createdAt=now end
if p.finalLedgerKey then
  p.values[p.responseSessionIndex].ledger[p.finalLedgerKey].final.serverNow=now
  if p.receiptKeyIndex then p.values[p.receiptKeyIndex].entry.final.serverNow=now end
end
local response=p.response
if response.ok and response.value then
  if p.replay then
    if response.value.kind=='COMPLETED' or response.value.kind=='REPLAY_COMPLETED' then response.value.kind='REPLAY_COMPLETED' else response.value.kind='REPLAY' end
    response.value.events={}
  else
    if response.value.session then
      local document=p.values[p.responseSessionIndex]
      if document and document~=cjson.null then response.value.session=document.session end
    end
    response.value.serverNow=now
  end
end
local encodedResponse=cjson.encode({committed=true,response=response})
local writes={}
local expirations={}
for i=1,count do local key=KEYS[i]
  local value=p.values[i]
  if p.changed[i] and value and value~=cjson.null then
    local encoded=cjson.encode(value)
    table.insert(writes,key)
    table.insert(writes,encoded)
    if value.session then
      local s=value.session
      local deadline=math.max(s.recoveryRetainUntil,s.processingDeadlineAt or 0)+p.replayMs
      if deadline<=now or deadline>9007199254740991 then return redis.error_reply('Invalid metadata retention') end
      table.insert(expirations,{key=key,deadline=deadline})
    end
  end
end
if #writes>0 then redis.call('MSET',unpack(writes)) end
for _,expiry in ipairs(expirations) do redis.call('PEXPIREAT',expiry.key,expiry.deadline) end
return encodedResponse
`;

/** One-time bounded catalog work, with no checkout-wide CAS dependency. */
export const SEED_LUA = String.raw`
local p=cjson.decode(ARGV[1])
if p.generation and (redis.call('GET',KEYS[#KEYS]) or 'base')~=p.generation then return cjson.encode({seeded=false,error='Retired demo generation'}) end
for i=1,p.legacyCount do
  if redis.call('EXISTS',KEYS[i])==1 then return cjson.encode({seeded=false,error='Legacy v1 data requires migration or a new isolated CHECKOUT_NAMESPACE'}) end
end
local missing={}
for i,value in ipairs(p.values) do
  local key=KEYS[p.legacyCount+i]
  local existing=redis.call('GET',key)
  if existing then
    local d=cjson.decode(existing)
    if d.schemaVersion~=2 then return cjson.encode({seeded=false,error='Unsupported persistence schema'}) end
  else
    table.insert(missing,key)
    table.insert(missing,cjson.encode(value))
  end
end
if #missing>0 then redis.call('MSET',unpack(missing)) end
return cjson.encode({seeded=true})
`;

/** Reset publishes all fresh fixture inventories and the routing fence together.
 * Old workers compare this fence in every snapshot/commit, including settlement.
 */
export const RESET_LUA = String.raw`
local p=cjson.decode(ARGV[1])
if (redis.call('GET',KEYS[1]) or 'base')~=p.expected then return 0 end
local writes={KEYS[1],p.generation}
for i,value in ipairs(p.values) do
  table.insert(writes,KEYS[i+1])
  table.insert(writes,cjson.encode(value))
end
redis.call('MSET',unpack(writes))
return 1
`;
