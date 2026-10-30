# Local rewards system (no Google account)

## Top 1 frame
- When you are #1 on local board (`l1p_board`) or server leaderboard (`__L1PServerBoard`), **TOP 1 LEGEND** frame is granted into BAG and can auto-equip.
- Survives in `localStorage` key `l1p_v3` (`bagItems`, `equippedFrame`).

## Event claims (device + optional server memory)
- WEEKEND EVENTS → Claim Play / Win / MVP
- Once per ISO week per kind (stored in `state.eventClaims`)
- Coins + frame + BAG reward item
- Server also remembers claims in RAM via `event:claim` (resets on server restart)

## BAG
- Frames: tap to equip (border on profile + HUD)
- Reward items: history of event/mission prizes
- Guns still primarily in SHOP

## Not included
Cloud account sync across phones (needs Google + DB).
