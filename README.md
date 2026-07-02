# BTC AI Backend v73 — Independent Execution AI

This version separates **direction** from **trade action**.

- AI analyzes raw market data first.
- AI returns direction: ABOVE / BELOW / SIT_OUT.
- AI returns trade action: ACT_NOW / PREPARE / WAIT / DO_NOT_CHASE / SIT_OUT / FIX_DATA.
- Engine comparison is advisory unless there is unusable data or true opposite-direction conflict.
- If the engine is merely more conservative, the AI can still show ACT_NOW/PREPARE with a warning instead of being forced to SIT_OUT.
