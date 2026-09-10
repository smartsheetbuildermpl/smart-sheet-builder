# Smart Sheet Builder by Master PrintLab

Vercel-ready Next.js wrapper for the stable Smart Sheet Builder V5.2.4 HTML app.

## Local Run

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Deploy To Vercel

1. Push this folder to GitHub.
2. Import the repo in Vercel.
3. Framework preset: `Next.js`.
4. Build command: `npm run build`.
5. Output directory: leave default.

## Current Architecture

- `app/page.jsx` loads the working builder through `/public/builder.html`.
- `public/builder.html` contains the stable Smart Sheet Builder V5.2.4 logic.
- This keeps the working TIFF export behavior intact while preparing the app for login, account controls, and backend export later.
