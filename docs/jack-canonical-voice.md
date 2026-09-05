# Jack canonical voice operations

Jack uses ElevenLabs server-side speech generation with one approved voice ID. Browser or Android system speech is not a fallback. Missing configuration or provider failure leaves text available and exposes unavailable speech in Jack.

## Register Derek's voice

Derek has explicitly approved his own voice as Jack's identity. `DCvoice.m4a` is the canonical reference. The located reference is `D:/TorchTemp/JackVoice/DCvoice.m4a`: 699,576 bytes, 41.856 seconds, mono AAC at 48 kHz, SHA-256 `8B677812F4694117C219441A1510ABA3C7061304D9C59A2BD0EDF866FF644CEB`. Verify that digest before registration; do not substitute a stock voice or register another person's audio. Keep the reference outside Git, build contexts, public assets, and CI artifacts.

In the authorized ElevenLabs account, register a voice clone from `DCvoice.m4a`, completing the provider's ownership verification as required. Audition it against the reference and have Derek confirm that it is recognizably his voice. Record the resulting immutable voice ID as the canonical identity. Do not create a fresh clone per request, session, or release. Account access and any new paid commitment must be resolved before registration.

## Configure production

Set repository Actions secrets `ELEVENLABS_API_KEY` and `JACK_VOICE_ID` for `chokle/Jack-Core` using the approved provider key and canonical voice ID. Use secret-entry controls; never paste either value into tracked files, command logs, or PR comments. The production workflow passes them only through its Worker secret handoff, and the Worker forwards them to the API container. Neither belongs in a `VITE_` variable or Docker build argument.

Both secrets are optional for deploying the app: absent values intentionally disable speech while preserving authenticated text use. This is a degraded deployment, not voice acceptance. The obsolete `VITE_JACK_VOICE_HINT` setting has no effect and may be removed from repository variables.

Deploy the exact reviewed commit through the production workflow. Verify its terminal success, exact image/runtime identity, and both the workers.dev and `jack.torchlabs.ca` routes. Existing containers may retain their startup environment: confirm that the active container was replaced after secret changes, rather than assuming a secret update refreshed it.

## Acceptance evidence

On authenticated Pixel 9 Pro XL Chrome, listen to actual Jack output and record the tested commit, production runtime, date, and Derek's verdict. Test repeated responses, page navigation, reload, a new session, voice input, and text input. The audible identity must stay recognizably Derek. Verify context after navigating to a specific node/page and going back/forward.

Exercise missing configuration, provider rejection/timeout, and blocked audio playback in a controlled test environment. Text must remain usable and speech must visibly degrade without any system-voice substitution. Local tests and a successful HTTP response do not establish audible acceptance. Keep the voice gate open until Derek's actual cloned voice has been heard in Jack on the physical device.

If voice delivery fails, disable the provider configuration or fix forward with the same canonical identity. Do not roll back to browser speech synthesis or silently choose another voice.
