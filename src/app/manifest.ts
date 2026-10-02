import type { MetadataRoute } from "next";
import { APP_THEME_COLOR } from "@/lib/app-theme";

/**
 * Web app manifest, served by Next at `/manifest.webmanifest` and linked from every page.
 * This is what makes the site installable ("Add to Home screen" / "Install app").
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "JPL India",
    short_name: "JPL",
    description: "JPL India — Fantasy Football League Management",
    // Redirects to the viewer's own dashboard, or the league list when signed out.
    start_url: "/launch",
    scope: "/",
    display: "standalone",
    background_color: APP_THEME_COLOR,
    theme_color: APP_THEME_COLOR,
    categories: ["sports", "entertainment"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
