export default function Footer() {
  const currentYear = new Date().getFullYear();

  return (
    <footer className="py-12 px-6 border-t border-neutral-800/50">
      <div className="max-w-3xl mx-auto">
        <p className="text-sm text-neutral-600 font-light">
          © {currentYear} Substrate Systems OÜ
        </p>
      </div>
    </footer>
  );
}
