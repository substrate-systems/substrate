import Hero from "@/components/Hero";
import SectionFade from "@/components/SectionFade";
import Hook from "@/components/Hook";
import Philosophy from "@/components/Philosophy";
import Products from "@/components/Products";
import Footer from "@/components/Footer";

export default function Home() {
  return (
    <main className="min-h-screen bg-bg-base">
      <Hero />
      <SectionFade />
      <Hook />
      <Philosophy />
      <Products />
      <Footer />
    </main>
  );
}
