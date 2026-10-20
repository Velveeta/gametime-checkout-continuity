import { withCheckoutApi } from "@/lib/checkout-runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const {id}=await context.params;
  return withCheckoutApi((api)=>api.confirmation(request,id));
}
