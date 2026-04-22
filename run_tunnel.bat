@echo off
title FrameAI Tunnel
REM Starts the Cloudflare tunnel, forwarding public traffic to the PROD server on localhost:5000.
REM Quick-tunnel mode (random *.trycloudflare.com URL). Swap to a named tunnel later:
REM   cloudflared tunnel run <tunnel-name>
"C:\Program Files (x86)\cloudflared\cloudflared.exe" tunnel --url http://localhost:5000
