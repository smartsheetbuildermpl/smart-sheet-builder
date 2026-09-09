import "./globals.css";

export const metadata = {
  title: "Smart Sheet Builder by Master PrintLab",
  description: "Multi-machine TIFF gang sheet builder for DTF, UV-DTF, and Tarpaulin."
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
