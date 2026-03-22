import { Html, Head, Main, NextScript } from "next/document";

export default function Document() {
  return (
    <Html lang="en" data-theme="dark">
      <Head />
      <body className="antialiased bg-surface text-content">
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
