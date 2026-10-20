import { withCheckoutApi } from "@/lib/checkout-runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return withCheckoutApi((api)=>api.events());
}
