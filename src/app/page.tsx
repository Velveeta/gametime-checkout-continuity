import { Button } from "@/components/ui/button";

export default function Home() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-3xl flex-col justify-center px-6 py-16">
      <p className="mb-4 text-sm font-semibold tracking-widest text-primary uppercase">Engineering assessment</p>
      <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">Checkout Continuity</h1>
      <p className="mt-6 max-w-xl text-lg leading-relaxed">A foundation for a checkout that follows you across devices.</p>
      <section aria-labelledby="foundation-title" className="mt-10 rounded-xl border border-border bg-white p-6">
        <h2 id="foundation-title" className="text-xl font-semibold">Foundation ready</h2>
        <p className="mt-3 leading-relaxed">Catalog, inventory, and checkout interactions will arrive in later implementation waves.</p>
        <p id="simulation-note" className="mt-4 text-sm leading-relaxed">All events, dates, listings, prices, and purchases are simulated. No real payments are accepted.</p>
        <Button disabled aria-describedby="simulation-note" className="mt-6">Ticket browsing coming soon</Button>
      </section>
    </main>
  );
}
