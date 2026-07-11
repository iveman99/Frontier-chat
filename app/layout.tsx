import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Frontier Hub by iVeman — Access the world's best AI models",
  description:
    "One interface for frontier AI models (Claude Opus, GPT-5.5, GLM). Bring your own API key and switch models instantly.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
