# MD Tuning Lab - Admin Web

Portale admin statico per la gestione ordini centraline (Firebase Auth + Firestore).

## Pubblicazione su GitHub Pages

1. Crea un repository su GitHub (es. `admin-web`).
2. Carica **il contenuto di questa cartella** nella root del repository (non la cartella stessa). Nella root del repo devono esserci:
   - `index.html`
   - `app.js`
   - `styles.css`
   - `firebase-config.js`
   - `.nojekyll`
3. Su GitHub: **Settings → Pages → Source: "Deploy from a branch"** → Branch: `main`, cartella `/ (root)` → **Save**.
4. Attendi 1-2 minuti. La pagina sarà disponibile su:
   `https://<tuo-username>.github.io/<nome-repo>/`

## Accesso

- Login con email/password Firebase.
- L'utente deve avere `isAdmin: true` nel documento `users/{uid}` su Firestore (database `dati`).

## Note

- L'API key Firebase in `firebase-config.js` è una chiave client pubblica: la sicurezza è garantita dalle Firestore Rules.
- Non serve aggiungere il dominio GitHub Pages ai domini autorizzati Firebase per il login email/password.
