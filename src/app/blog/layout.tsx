import type { Metadata } from "next";

export const metadata: Metadata = {
  title: {
    template: "%s · Substrate",
    default: "Writing · Substrate",
  },
};

export default function BlogLayout({ children }: { children: React.ReactNode }) {
  return children;
}
