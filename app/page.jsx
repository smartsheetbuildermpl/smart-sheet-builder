export default function HomePage() {
  return (
    <main className="app-shell">
      <iframe
        className="builder-frame"
        src="/builder.html"
        title="Smart Sheet Builder by Master PrintLab"
      />
      <noscript>
        <div className="noscript-message">
          Smart Sheet Builder needs JavaScript enabled to arrange and export sheets.
        </div>
      </noscript>
    </main>
  );
}
