/** Built Next + actual Upstash SDK + test-only REST protocol bridge + REAL Redis.
 * The bridge is not the hosted Upstash service; hosted validation is separate.
 */
import { randomUUID } from "node:crypto";
import { createServer as httpsServer, type Server } from "node:https";
import { createServer } from "node:net";
import { spawn,execFile,type ChildProcess } from "node:child_process";
import { mkdtemp,readFile,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { setTimeout as pause } from "node:timers/promises";
import { afterAll,beforeAll,expect,it } from "vitest";
import { RedisHarness } from "../integration/redis-harness";
import { composeCheckout } from "../../src/infrastructure/checkout/compose";
import { DEFAULT_CHECKOUT_POLICY } from "../../src/domain/checkout";
import { listings } from "../../src/infrastructure/catalog/fixtures";
import { version } from "../../src/domain/values";

const run=promisify(execFile);const redis=new RedisHarness();const children:ChildProcess[]=[];
const namespace=`http-${randomUUID()}`;const callerSecret="http-caller-".repeat(4);const completionSecret="http-completion-".repeat(4);
let directory="";let bridge:Server|undefined;const bases:string[]=[];
async function freePort() {return new Promise<number>((resolve,reject)=>{const server=createServer();server.once("error",reject);server.listen(0,"127.0.0.1",()=>{const a=server.address();if(!a||typeof a==="string")throw new Error();server.close((error)=>error?reject(error):resolve(a.port));});});}
beforeAll(async()=>{
  await redis.start();directory=await mkdtemp(join(tmpdir(),"cc-http-"));
  const key=join(directory,"key.pem");const cert=join(directory,"cert.pem");
  await run("openssl",["req","-x509","-newkey","rsa:2048","-nodes","-keyout",key,"-out",cert,"-days","1","-subj","/CN=localhost","-addext","subjectAltName=IP:127.0.0.1,DNS:localhost"]);
  bridge=httpsServer({key:await readFile(key),cert:await readFile(cert)},async(request,response)=>{
    try{
      if(request.headers.authorization!=="Bearer local-protocol-test"){response.writeHead(401);response.end(JSON.stringify({error:"Unauthorized"}));return;}
      const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));
      const body=JSON.parse(Buffer.concat(chunks).toString());
      const invoke=async(command:unknown[])=>{
        const raw=await redis.command(...command.map(String));
        return {result:request.headers["upstash-encoding"]==="base64"?Buffer.from(raw).toString("base64"):raw};
      };
      const result=request.url?.startsWith("/pipeline")?await Promise.all(body.map(invoke)):await invoke(body);
      response.setHeader("Content-Type","application/json");response.end(JSON.stringify(result));
    }catch{response.writeHead(500);response.end(JSON.stringify({error:"Test REST bridge error"}));}
  });
  const bridgePort=await freePort();await new Promise<void>((resolve)=>bridge!.listen(bridgePort,"127.0.0.1",resolve));
  for(let n=0;n<2;n++){
    const port=await freePort();const base=`http://127.0.0.1:${port}`;bases.push(base);
    let logs="";
    const child=spawn(process.execPath,["node_modules/next/dist/bin/next","start","--hostname","127.0.0.1","--port",String(port)],{
      cwd:process.cwd(),env:{...process.env,NODE_ENV:"production",NEXT_TELEMETRY_DISABLED:"1",NODE_EXTRA_CA_CERTS:cert,
        UPSTASH_REDIS_REST_URL:`https://127.0.0.1:${bridgePort}`,UPSTASH_REDIS_REST_TOKEN:"local-protocol-test",CHECKOUT_NAMESPACE:namespace,
        CHECKOUT_CALLER_SECRET:callerSecret,CHECKOUT_COMPLETION_SECRET:completionSecret,DEMO_MODE:"false",DEMO_SECRET:"",PAYMENT_SCENARIO:"SUCCESS"},stdio:["ignore","pipe","pipe"]});
    children.push(child);child.stdout?.on("data",(data)=>{logs=(logs+data.toString()).slice(-10000);});child.stderr?.on("data",(data)=>{logs=(logs+data.toString()).slice(-10000);});
    let ready=false;
    for(let attempt=0;attempt<100;attempt++){
      try{if((await fetch(base)).status===200){ready=true;break;}}catch{}
      if(child.exitCode!==null)break;await pause(50);
    }
    if(!ready)throw new Error("Built Next server failed to start: "+logs);
  }
});
afterAll(async()=>{
  for(const child of children)if(child.exitCode===null){const exited=new Promise<void>((resolve)=>child.once("exit",()=>resolve()));child.kill("SIGTERM");await exited;}
  if(bridge){bridge.closeAllConnections();await new Promise<void>((resolve)=>bridge!.close(()=>resolve()));}
  await redis.stop();if(directory)await rm(directory,{recursive:true,force:true});
});
it("serves real Route Handlers through two Next instances, SDK/TLS, Redis, and SSR redirects",async()=>{
  const [a,b]=bases;const listing=listings[0]!;if(listing.allocation.kind!=="ASSIGNED")throw new Error();
  const allocation={...listing.allocation,seats:[9,10] as [number,number]};
  const posted=await fetch(a+"/api/checkouts",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({eventId:listing.eventId,listingId:listing.id,allocation,expectedListingVersion:1})});
  const postedBody=await posted.json();expect(posted.status,JSON.stringify(postedBody)).toBe(201);
  const s=postedBody.data;const caller=posted.headers.getSetCookie()[0]!.split(";")[0]!;
  const page=await fetch(b+`/checkout/${s.session.id}`,{redirect:"manual"});expect(page.status).toBe(200);expect(await page.text()).toContain("Checkout");expect(page.headers.get("cache-control")).toContain("no-store");
  const input={expectedVersion:s.session.version,quoteVersion:s.session.quote.version};
  const purchase=await fetch(b+`/api/checkouts/${s.session.id}/complete`,{method:"POST",headers:{"Content-Type":"application/json","Idempotency-Key":"purchase",Cookie:caller},body:JSON.stringify(input)});
  const completed=await purchase.json();expect(purchase.status,JSON.stringify(completed)).toBe(200);expect(completed.data.kind).toBe("COMPLETED");expect(completed.data.capability).toBeUndefined();
  const confirmationCookie=purchase.headers.getSetCookie()[0]!.split(";")[0]!;
  const confirmed=await fetch(a+completed.data.confirmationUrl,{headers:{Cookie:confirmationCookie}});expect(confirmed.status).toBe(200);expect((await confirmed.json()).data.id).toBe(completed.data.orderId);
  const replay=await fetch(a+`/api/checkouts/${s.session.id}/complete`,{method:"POST",headers:{"Content-Type":"application/json","Idempotency-Key":"purchase",Cookie:caller},body:JSON.stringify(input)});expect(await replay.json()).toEqual(completed);
  const terminalPage=await fetch(a+`/checkout/${s.session.id}`,{redirect:"manual"});expect([303,307]).toContain(terminalPage.status);expect(terminalPage.headers.get("location")).toBe("/");
  const malformed=await fetch(a+"/api/checkouts",{method:"POST",headers:{"Content-Type":"application/json"},body:"{"});expect(malformed.status).toBe(400);
  // Prepare an expired checkout without exposing developer operations over HTTP.
  const setup=await composeCheckout({redis,namespace,callerSecret,completionSecret,secureCookies:true,policy:{...DEFAULT_CHECKOUT_POLICY,holdMs:120},analytics:{record:async()=>{}}});
  const short=await setup.checkout.create({listingId:listing.id,allocation:{...allocation,seats:[11,12]},expectedListingVersion:version(1)});if(!short.ok)throw short.error;
  await redis.after(short.value.session.reservationExpiresAt);
  const expiredJson=await fetch(b+`/api/checkouts/${short.value.session.id}`);expect(expiredJson.status).toBe(410);
  const stalePage=await fetch(a+`/checkout/${short.value.session.id}`,{redirect:"manual"});expect([303,307]).toContain(stalePage.status);expect(stalePage.headers.get("location")).toMatch(/^\/checkout\//);expect(stalePage.headers.get("location")).not.toBe(`/checkout/${short.value.session.id}`);
});
