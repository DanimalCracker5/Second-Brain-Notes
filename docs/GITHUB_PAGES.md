# Publish Second Brain with GitHub Pages

This project is already prepared for GitHub Pages. Use the repository **root**
as the Pages source; `index.html` is the app and keeps the public URL clean.

1. Create a new GitHub repository. For a free GitHub account, make it public.
2. Upload the contents of this project, keeping the folders intact:
   `index.html`, `astral.config.js`, `backups/`, `firebase.json`, `firestore.rules`, and
   `Start Second Brain.cmd`.
3. Open the repository on GitHub and choose **Settings → Pages**.
4. Under **Build and deployment**, choose **Deploy from a branch**.
5. Choose your main branch and folder **`/ (root)`**, then click **Save**.
6. Wait for GitHub to publish the site. The address will be:
   `https://YOUR-USERNAME.github.io/YOUR-REPOSITORY/`
7. In Firebase Console, open **Authentication → Settings → Authorized domains**
   and add `YOUR-USERNAME.github.io` (host only; do not include the repository
   path).

The `docs/` folder is documentation, not the Pages publishing source. Keep the
Pages source set to root.

The Firebase web config in `astral.config.js` is expected to be public for
a browser app. Do not upload service-account keys or other private secrets.
