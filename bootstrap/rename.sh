# $HEIST -> $PROMPT, /claimheist -> /claimprompt everywhere except the workflow
grep -rIl -i "heist" --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.github --exclude-dir=bootstrap . | xargs sed -i -e 's/\$HEIST/$PROMPT/g' -e 's/claimheist/claimprompt/g'
