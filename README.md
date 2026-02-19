### to transform tout de png à webp :

for f in *.png; do   cwebp -lossless "$f" -o "${f%.png}.webp"; done


### dans maps.json

id = nom du répertoire des tiles