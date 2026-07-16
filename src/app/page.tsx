import Hero from "@/components/Hero";
import LandingNarrative from "@/components/LandingNarrative";
import Footer from "@/components/Footer";

export default function Home() {
  return (
    <main className="min-h-screen bg-bg-base">
      <Hero />
      <LandingNarrative />
      <Footer />
    </main>
  );
}
