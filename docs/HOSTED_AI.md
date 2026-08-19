# Hosted AI credits

Second Brain can sell convenience: signed-in people talk to agents without pasting OpenAI, Gemini, or ElevenLabs keys. Those keys stay in Cloud Functions secrets. The browser never receives them.

Users buy prepaid credits in the app. Every hosted call is billed at **5×** the provider cost, so $5 of credits covers about $1 of model and voice usage.

Bring-your-own-keys still works. It is the advanced path, not the default.

## What to deploy

1. **Blaze billing** on the Firebase project (`second-brain-4077e`). Cloud Functions and Stripe webhooks need it.
2. **Functions + rules** from this repo:

```bash
firebase deploy --project second-brain-4077e --only functions,firestore:rules
```

3. **Secrets** (never commit these):

```bash
firebase functions:secrets:set OPENAI_API_KEY --project second-brain-4077e
firebase functions:secrets:set GEMINI_API_KEY --project second-brain-4077e
firebase functions:secrets:set ELEVENLABS_API_KEY --project second-brain-4077e
firebase functions:secrets:set STRIPE_SECRET_KEY --project second-brain-4077e
firebase functions:secrets:set STRIPE_WEBHOOK_SECRET --project second-brain-4077e
```

4. **Stripe webhook** pointing at:

`https://us-central1-second-brain-4077e.cloudfunctions.net/ai/stripe`

Listen for `checkout.session.completed`. Paste the signing secret into `STRIPE_WEBHOOK_SECRET`.

5. Optional: set `APP_URL` if the public site is not `https://secondbrainnotes.com`:

```bash
firebase functions:config:unset is unused
# For 2nd gen, pass APP_URL as an environment variable in the function config or set it in functions/index.js.
```

The client URL lives in `astral.config.js` as `hostedAi.baseUrl`. If you redeploy functions to another region, update that value.

## How money is protected

- Provider keys are only read inside Cloud Functions.
- Firestore `billing/{uid}` is **read-only for the signed-in user**. Only the Admin SDK (the function) can change a balance.
- The function holds credits before calling a provider, then settles the real 5× cost from provider usage. The client cannot report its own token counts.
- Models, voice ids, payload size, rate, and concurrency are limited on the server. Unknown models are rejected rather than billed at a guess.
- Gemini Live ears stays off on the hosted path because that API needs a key in the browser.

## Local tests

```bash
cd functions
npm test
```

Those tests cover markup math, model allowlisting, holds, and purchase idempotency. They do not call OpenAI or Stripe.
