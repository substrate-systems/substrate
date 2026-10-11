import { ExomemThemeScope } from "./exomem-theme-scope";

export default function ExomemLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <ExomemThemeScope />
      {children}
    </>
  );
}
