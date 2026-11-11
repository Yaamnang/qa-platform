#!/usr/bin/env bash
# Deploy the QA console and the stand-in on one Ubuntu server.
#
#   git clone <your repo> eclypse && cd eclypse && bash scripts/deploy.sh
#
# Run it again after a git pull to update. It needs a .env file next to this
# repo's package.json (copy .env.example and fill in what you use). Nothing
# secret is written by this script.
set -euo pipefail

PORT="${PORT:-3000}"

echo "• Node.js"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

echo "• Dependencies"
npm ci

echo "• Browser for Probe and Explore, with its system libraries"
npx playwright install --with-deps chromium

echo "• Build"
npm run build

echo "• Process manager"
command -v pm2 >/dev/null || sudo npm install -g pm2
# Plain http on a bare IP needs non-secure cookies; drop this once TLS is in front.
export INSECURE_COOKIES="${INSECURE_COOKIES:-1}"
if pm2 describe eclypse >/dev/null 2>&1; then
  pm2 restart eclypse --update-env
else
  pm2 start npm --name eclypse -- start -- -p "$PORT"
fi
pm2 save

echo
echo "Running on port $PORT. Open http://<server-ip>:$PORT/login"
echo "Set CONSOLE_PUBLIC_URL=http://<server-ip>:$PORT in .env so links on GitHub commits point here."
