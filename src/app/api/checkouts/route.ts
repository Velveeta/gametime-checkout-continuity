import { withCheckoutApi } from "@/lib/checkout-runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  return withCheckoutApi((api)=>api.create(request));
}
