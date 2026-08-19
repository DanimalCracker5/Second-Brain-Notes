# Publish Second Brain with GitHub Pages

This project is already prepared for GitHub Pages. Use the repository **root**
as the Pages source; `index.html` is the app and keeps the public URL clean.

1. Create a new GitHub repository. For a free GitHub account, make it public.
2. Upload the contents of this project, keeping the folders intact:
   `index.html`, `shared.html`, `astral.config.js`, `backups/`, `firebase.json`, `firestore.rules`, and
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

## Firebase rules

Deploy the checked-in Firebase rules whenever you first enable cloud sync or
after pulling changes that touch `firestore.rules` or `storage.rules`. Deploy
only the service whose rules changed:

```powershell
# For public view-only sharing or the cloud-storage meter change:
firebase deploy --project second-brain-4077e --only firestore:rules

# For the cloud-storage meter change:
firebase deploy --project second-brain-4077e --only storage

# Only when both rule files changed:
firebase deploy --project second-brain-4077e --only firestore:rules,storage
```

The Storage rules let signed-in users sync and enumerate attachments only
within their own account path. Enumeration lets the in-app storage meter count
the files actually retained in Cloud Storage, including any orphaned files that
still consume storage. Device-only attachments still work without signing in.

## Hosted AI credits

To sell convenience (users talk without pasting their own provider keys),
deploy Cloud Functions and the updated Firestore rules. See `docs/HOSTED_AI.md`.
Never put OpenAI, Gemini, ElevenLabs, or Stripe secrets in this repo.

## Public view-only links

The **Share** button on a note or video script creates a link to `shared.html`.
Anyone with that link can view the published snapshot without signing in, but
cannot list shared documents, edit them, or access the author's private notes.
Changes made after publishing are refreshed the next time the note syncs; use
**Public link → Stop public sharing** to revoke a link. Deploy the Firestore
rules above before using this feature.
