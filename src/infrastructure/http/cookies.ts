import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export const CALLER_COOKIE = "cc_caller";
export function cookie(request: Request, name: string) {
  const entry = request.headers.get("cookie")?.split(";").map((p)=>p.trim()).find((p)=>p.startsWith(name+"="));
  return entry?.slice(name.length+1);
}
export function confirmationCookie(orderId: string) { return `cc_confirmation_${orderId}`; }
export class CallerCookies {
  constructor(private readonly secret: string, private readonly secure: boolean) {
    if (Buffer.byteLength(secret)<32) throw new Error("Caller secret must be at least 32 bytes");
  }
  private sign(id:string) { return createHmac("sha256",this.secret).update(`caller-v1:${id}`).digest("base64url"); }
  read(request:Request):string|undefined {
    const value=cookie(request,CALLER_COOKIE);
    if(!value) return undefined;
    const [id,signature,...rest]=value.split(".");
    if(!id || !signature || rest.length || !/^[0-9a-f-]{36}$/.test(id)) return undefined;
    const expected=this.sign(id);
    return expected.length===signature.length && timingSafeEqual(Buffer.from(expected),Buffer.from(signature)) ? id : undefined;
  }
  create() { const id=randomUUID(); return this.serialize(CALLER_COOKIE,`${id}.${this.sign(id)}`); }
  serialize(name:string,value:string) {
    return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800${this.secure?"; Secure":""}`;
  }
}
