import type { Metadata, Viewport } from "next";
import { Rubik } from "next/font/google";
import "./globals.css";

const rubik = Rubik({ subsets: ["latin"], weight: ["400", "500", "600", "700", "800", "900"], variable: "--font-rubik" });

export const metadata: Metadata = {
  title: "FUSÉE · le jeu de la fusée sur Monad",
  description: "Crash game on Monad: bet test USDC, cash out before the jet flies away. Two transactions per flight.",
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "FUSÉE" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  themeColor: "#070a24",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr" className={rubik.variable}>
      <body>{children}</body>
    </html>
  );
}
