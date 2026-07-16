# SMDApp systemd (user) services

These units run the full SMDApp stack as **systemd user services** so they
survive logout and reboot. They live in `~/.config/systemd/user/` on the
deploy machine; copies are kept here for version control.

## Units

| Unit | Purpose |
|---|---|
| `smdapp.service` | Next.js API server on port 3000 (`next dev -p 3000`) |
| `smd-cron.service` | `scripts/dailyScanCron.ts` — Telegram alerts, BTST, after-hours DOM capture |

## Install

```bash
# From repo root
cp deploy/systemd/smdapp.service ~/.config/systemd/user/
cp deploy/systemd/smd-cron.service ~/.config/systemd/user/

# Allow user services to keep running after logout/reboot
sudo loginctl enable-linger "$USER"

systemctl --user daemon-reload
systemctl --user enable smdapp.service smd-cron.service
systemctl --user start smdapp.service smd-cron.service
```

## Scheduled jobs (in dailyScanCron.ts)

| Schedule (IST, Mon–Fri) | Job |
|---|---|
| `10 9 * * 1-5` | Morning Telegram digest |
| `*/15 9-15 * * 1-5` | Intraday trade alerts (every 15 min) |
| `15 15 * * 1-5` | BTST scan |
| `25 15 * * 1-5` | Square off prior-day BTST |
| `35 19 * * 1-5` | After-hours DOM capture → `DomAnalysis` table |

## Notes

- `smd-cron.service` has `Requires=smdapp.service`, so it only runs once the
  API is up. Both use `Restart=always`.
- `smd-cron` reads `.env` from the project dir for `TELEGRAM_*` / `DAILY_SCAN_SECRET`.
- ICICI Breeze session tokens expire daily — update `BREEZE_SESSION_TOKEN`
  in `.env` and `systemctl --user restart smdapp` when Breeze auth fails.
- The `ExecStart` paths assume bun at `/home/sachin/.bun/bin/bun` and the
  project at `/home/sachin/Desktop/SMDApp`. Adjust for other machines.
