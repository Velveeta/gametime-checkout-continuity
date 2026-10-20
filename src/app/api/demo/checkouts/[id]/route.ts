import { withDemoApi } from '@/lib/checkout-runtime';

export const runtime = 'nodejs';

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;

  return withDemoApi((api) => api.dispatch(request, id, 'status'));
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;

  return withDemoApi((api) => api.dispatch(request, id, 'mutate'));
}
