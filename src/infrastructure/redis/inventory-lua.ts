/** Reusable, write-free inventory functions for future checkout/order Lua scripts.
 * Compose functions BEFORE any Redis writes: Redis Lua is isolated but does not
 * roll back writes on script errors. The runner below commits one event document.
 */
export const INVENTORY_LUA_CORE = String.raw`
local function result(value) return {ok=true, value=value} end
local function failure(code) return {ok=false, code=code} end
local function integer(value) return type(value)=='number' and value>=1 and value==math.floor(value) and value<=9007199254740991 end
local function same(a,b)
  if type(a)~=type(b) then return false end
  if type(a)~='table' then return a==b end
  for key,value in pairs(a) do if not same(value,b[key]) then return false end end
  for key in pairs(b) do if a[key]==nil then return false end end
  return true
end
local function quantity(allocation)
  if allocation.kind=='ASSIGNED' then return #allocation.seats end
  return allocation.quantity
end
local function effectiveDeadline(reservation)
  -- Wave 02 may add processing protection only after an atomic completion claim.
  return reservation.processingDeadlineMs or reservation.expiresAtMs
end
local function inventoryReconcile(state,now)
  for _,reservation in pairs(state.reservations) do
    if reservation.status=='HELD' and effectiveDeadline(reservation)<=now then
      reservation.status='EXPIRED'
      state.version=state.version+1
    end
  end
end
local function occupied(state,listingId)
  local seats={}
  local held=0
  local sold=0
  for _,reservation in pairs(state.reservations) do
    if reservation.listingId==listingId and (reservation.status=='HELD' or reservation.status=='SOLD') then
      local count=quantity(reservation.allocation)
      if reservation.status=='HELD' then held=held+count else sold=sold+count end
      if reservation.allocation.kind=='ASSIGNED' then
        for _,seat in ipairs(reservation.allocation.seats) do seats[tostring(seat)]=true end
      end
    end
  end
  return seats,held,sold
end
local function inventoryAvailability(state,listingId,owner,now)
  local listing=state.listings[listingId]
  if not listing then return failure('NOT_FOUND') end
  local pool=listing.allocation
  local blocked,held,sold=occupied(state,listingId)
  local available={}
  local own={}
  if pool.kind=='ASSIGNED' then
    local run=nil
    for _,seat in ipairs(pool.seats) do
      if blocked[tostring(seat)] then
        run=nil
      else
        if not run then
          run={kind='ASSIGNED',section=pool.section,row=pool.row,seats={}}
          table.insert(available,run)
        end
        table.insert(run.seats,seat)
      end
    end
  else
    local remaining=pool.quantity-held-sold
    if remaining>0 then table.insert(available,{kind='GENERAL_ADMISSION',section=pool.section,quantity=remaining}) end
  end
  for _,reservation in pairs(state.reservations) do
    if reservation.listingId==listingId and reservation.status=='HELD' and reservation.sessionId==owner then
      table.insert(own,reservation)
    end
  end
  return result({available=available,ownReservations=own,version=state.version,serverNowMs=now,
    counts={total=quantity(pool),held=held,sold=sold,available=quantity(pool)-held-sold}})
end
local function inventoryReserve(state,request,holdDurationMs,now)
  local listing=state.listings[request.listingId]
  if not listing then return failure('NOT_FOUND') end
  local previous=state.reservations[request.reservationId]
  if previous then
    if previous.sessionId~=request.sessionId or previous.listingId~=request.listingId or
       previous.listingVersion~=request.expectedListingVersion or not same(previous.selection,request.selection) then
      return failure('RESERVATION_CONFLICT')
    end
    if previous.status=='EXPIRED' or previous.status=='RELEASED' then return failure('RESERVATION_EXPIRED') end
    if previous.status=='SOLD' then return failure('TERMINAL_SESSION') end
    return result(previous) -- idempotent replay NEVER changes the deadline or revision
  end
  for _,reservation in pairs(state.reservations) do
    if reservation.sessionId==request.sessionId and reservation.status=='HELD' then return failure('RESERVATION_CONFLICT') end
    if reservation.sessionId==request.sessionId and reservation.status=='SOLD' then return failure('TERMINAL_SESSION') end
  end
  if listing.version~=request.expectedListingVersion then return failure('VERSION_CONFLICT') end
  local pool=listing.allocation
  local selection=request.selection
  local selected=nil
  local requested=nil
  if selection.kind=='QUANTITY' then
    requested=selection.quantity
  elseif selection.kind=='EXACT' then
    selected=selection.allocation
    if selected.kind~=pool.kind or selected.section~=pool.section then return failure('INVALID_SELECTION') end
    if selected.kind=='ASSIGNED' then
      if selected.row~=pool.row or type(selected.seats)~='table' then return failure('INVALID_SELECTION') end
      requested=#selected.seats
      local members={}
      for _,seat in ipairs(pool.seats) do members[tostring(seat)]=true end
      for index,seat in ipairs(selected.seats) do
        if not integer(seat) or not members[tostring(seat)] or (index>1 and seat~=selected.seats[index-1]+1) then
          return failure('INVALID_SELECTION')
        end
      end
    else requested=selected.quantity end
  else return failure('INVALID_SELECTION') end
  local rules=listing.quantityRules
  if not integer(requested) or requested<rules.min or requested>rules.max or (requested-rules.min)%rules.increment~=0 then
    return failure('INVALID_SELECTION')
  end
  local blocked,held,sold=occupied(state,request.listingId)
  if pool.kind=='GENERAL_ADMISSION' then
    if requested>pool.quantity-held-sold then return failure('INVENTORY_UNAVAILABLE') end
    selected={kind='GENERAL_ADMISSION',section=pool.section,quantity=requested}
  elseif selected then
    for _,seat in ipairs(selected.seats) do
      if blocked[tostring(seat)] then return failure('INVENTORY_UNAVAILABLE') end
    end
  else
    local run={}
    for _,seat in ipairs(pool.seats) do
      if blocked[tostring(seat)] then run={} else table.insert(run,seat) end
      if #run==requested then break end
    end
    if #run~=requested then return failure('INVENTORY_UNAVAILABLE') end
    selected={kind='ASSIGNED',section=pool.section,row=pool.row,seats=run}
  end
  local reservation={id=request.reservationId,sessionId=request.sessionId,listingId=request.listingId,
    listingVersion=listing.version,selection=selection,allocation=selected,status='HELD',createdAtMs=now,expiresAtMs=now+holdDurationMs}
  state.reservations[request.reservationId]=reservation
  state.version=state.version+1
  return result(reservation)
end
local function inventoryCommitSale(state,request,now)
  local reservation=state.reservations[request.reservationId]
  if not reservation or reservation.listingId~=request.listingId then return failure('NOT_FOUND') end
  if reservation.sessionId~=request.sessionId then return failure('RESERVATION_CONFLICT') end
  if reservation.status=='SOLD' then
    if reservation.orderId==request.orderId then return result(reservation) end
    return failure('TERMINAL_SESSION')
  end
  if reservation.status~='HELD' or effectiveDeadline(reservation)<=now then return failure('RESERVATION_EXPIRED') end
  for _,other in pairs(state.reservations) do
    if other.status=='SOLD' and other.orderId==request.orderId then return failure('RESERVATION_CONFLICT') end
  end
  reservation.status='SOLD'
  reservation.orderId=request.orderId
  state.version=state.version+1
  return result(reservation)
end
`;

export const INVENTORY_LUA = INVENTORY_LUA_CORE + String.raw`
local request=cjson.decode(ARGV[1])
local time=redis.call('TIME')
local now=tonumber(time[1])*1000+math.floor(tonumber(time[2])/1000)
local raw=redis.call('GET',KEYS[1])
if request.kind=='INITIALIZE' then
  if not raw then
    redis.call('SET',KEYS[1],cjson.encode({schemaVersion=1,eventId=request.eventId,listings=request.listings,reservations={},version=1}),'NX')
  else
    local existing=cjson.decode(raw)
    if existing.schemaVersion~=1 or existing.eventId~=request.eventId then
      return redis.error_reply('Unsupported inventory schema or event')
    end
  end
  return cjson.encode(result(true))
end
if not raw then return cjson.encode(failure('NOT_FOUND')) end
local state=cjson.decode(raw)
if state.schemaVersion~=1 or state.eventId~=request.eventId then return redis.error_reply('Unsupported inventory schema or event') end
local originalVersion=state.version
inventoryReconcile(state,now)
local response=nil
if request.kind=='AVAILABILITY' then
  response=inventoryAvailability(state,request.listingId,request.ownerSessionId,now)
elseif request.kind=='RESERVE' then
  response=inventoryReserve(state,request.input,request.holdDurationMs,now)
elseif request.kind=='SELL' then
  response=inventoryCommitSale(state,request.input,now)
else return redis.error_reply('Unsupported inventory command') end
if state.version~=originalVersion then redis.call('SET',KEYS[1],cjson.encode(state)) end
return cjson.encode(response)
`;
