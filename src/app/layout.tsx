import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { PwaProvider } from "@/components/pwa/PwaProvider";
import { AccountSync } from "@/components/pwa/AccountSync";
import { APP_THEME_COLOR } from "@/lib/app-theme";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "JPL_India",
  description: "JPL India — Fantasy Football League Management",
  applicationName: "JPL",
  // iOS reads these instead of the manifest when the site is added to the home screen.
  // `black-translucent` lets the page draw under the status bar; the app bar pads itself with
  // `env(safe-area-inset-top)` to stay clear of the notch.
  appleWebApp: {
    capable: true,
    title: "JPL",
    statusBarStyle: "black-translucent",
  },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Draw edge to edge (under the notch / home indicator); safe-area insets are applied by the
  // app bar, bottom navigation and sheets. Pinch-zoom is deliberately left enabled.
  viewportFit: "cover",
  themeColor: APP_THEME_COLOR,
  colorScheme: "dark",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <PwaProvider>{children}</PwaProvider>
        <AccountSync />
      </body>
    </html>
  );
}
