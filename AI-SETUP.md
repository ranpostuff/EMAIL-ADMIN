# RescuePriority AI setup

The AI assistant uses NVIDIA Nemotron as its primary model and Gemini as an automatic fallback.

## Required Vercel variables

- `NVIDIA_API_KEY`: NVIDIA API key with access to public inference endpoints.
- `GEMINI_API_KEY`: Existing Gemini key used only when NVIDIA is unavailable.

Optional variables:

- `NVIDIA_MODEL`: Overrides the default `nvidia/nemotron-3-ultra-550b-a55b` model.
- `GEMINI_MODEL`: Overrides the default `gemini-3.6-flash` fallback model.

After adding or changing an environment variable, create a new Vercel deployment. Never place either secret in source files or commit them to Git.

## Efficiency behavior

- Exact count and ranking questions are answered locally from calculated dashboard statistics.
- Repeated questions over unchanged data are cached for two minutes in a warm serverless instance.
- Routine count and ranking questions bypass the model completely.
- Model-generated answers use non-thinking mode and strict length limits so the visible response is fast and complete. The supplied precomputed statistics still let Nemotron perform concise analysis without spending its output budget on a hidden reasoning trace.
- The last few messages are stored only in the current browser tab using `sessionStorage`, giving follow-up questions conversational context without permanently storing chat history.
- If NVIDIA fails or times out, Gemini answers automatically.

## Data supplied to the assistant

The browser prepares a compact, read-only snapshot containing active emergencies, incident totals, recent incidents, classroom and zone rankings, student incident rankings, incident types, violation rankings, a 30-day incident trend, resolution time, and time-of-day statistics. Test incidents are excluded.

Student names are included only in the administrator-facing context. Explicit test and latency records are excluded. The model is instructed not to make diagnostic, punitive, medical, or psychological conclusions from incident counts.
