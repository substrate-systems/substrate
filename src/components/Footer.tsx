import Image from "next/image";

export default function Footer() {
  const currentYear = new Date().getFullYear();

  return (
    <footer className="relative w-full py-16 border-t border-border-subtle">
      <div className="mx-auto w-full max-w-3xl px-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-6">
        <div className="relative h-4 w-[160px] opacity-40">
          <Image
            src="/brand/logos/substrate-logo-white-transparent.png"
            alt="Substrate"
            fill
            sizes="160px"
            className="object-contain"
          />
        </div>
        <p className="text-sm font-light text-fg-tertiary">© {currentYear} Substrate Systems OÜ</p>
      </div>
    </footer>
  );
}
