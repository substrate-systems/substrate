import Image from "next/image";

export default function Footer() {
  const currentYear = new Date().getFullYear();

  return (
    <footer className="py-16 px-6 border-t border-neutral-800/50">
      <div className="max-w-3xl mx-auto flex flex-col sm:flex-row sm:items-center sm:justify-between gap-6">
        <Image
          src="/brand/logos/substrate-logo-white-transparent.png"
          alt="Substrate"
          width={100}
          height={20}
          className="h-5 w-auto opacity-40"
        />
        <p className="text-sm text-neutral-600 font-light">
          © {currentYear} Substrate Systems OÜ
        </p>
      </div>
    </footer>
  );
}
