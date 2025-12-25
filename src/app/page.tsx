import Hero from "@/components/Hero";
import Hook from "@/components/Hook";
import Philosophy from "@/components/Philosophy";
import Products from "@/components/Products";
import CTA from "@/components/CTA";
import Footer from "@/components/Footer";

export default function Home() {
  return (
    <main className="min-h-screen bg-bg-base">
      <Hero />
      <Hook />
      <Philosophy />
      <Products />
      <CTA />
      <Footer />
    </main>
  );
}
