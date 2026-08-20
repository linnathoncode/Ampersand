import type { Metadata } from "next";

import "./styles.css";

export const metadata: Metadata = {
  title: "Model controls | Ampersand",
  description: "Manage trained model versions and publication status.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
