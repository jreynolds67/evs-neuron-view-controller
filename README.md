# EVS Neuron MV Control — Docker deployment

Static single-page app, served by nginx. The container only hosts the HTML/JS/CSS —
the browser (router panel or your PC) still talks directly to each board's
HTTP API and WebSocket feed over your studio LAN, so the host running this
container needs no special network access beyond serving the file.

## Run it

From this folder, on any machine with Docker installed:

```
docker compose up -d --build
```

That builds the image and starts it in the background, restarting
automatically on host reboot or crash (`restart: unless-stopped`).

The panel is then available at:

```
http://<docker_host_ip>:8080/
```

Point the Cerebrum router panel's embedded webpage URL at that address.

## Updating the page later

If you edit `index.html`, rebuild and restart:

```
docker compose up -d --build
```

## Stopping / removing

```
docker compose down
```

## Notes

- Change the host port by editing the left side of `"8080:80"` in
  docker-compose.yml if 8080 is already in use on that machine.
- This container has no persistent state of its own — board list and
  connection settings live in the browser's localStorage on whichever
  device displays the page (the router panel itself, in this case). If the
  panel's browser storage gets cleared, boards will need to be re-added.
- The page auto-detects screen height and switches to a compact horizontal
  strip layout under 420px tall, so the same container serves both your
  1895x291 and 1920x1080 panels without any config changes.
