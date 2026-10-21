# Pan Casero 3D

Simulador 3D para hacer pan en el navegador, hecho con **HTML, CSS y JavaScript** y [Three.js](https://threejs.org/).
Eliges un pan, pesas los ingredientes, mezclas, amasas, dejas fermentar, das forma, greñas, horneas… y al final
te puntúan el resultado y puedes cortar el pan para ver la miga.

Todo lo que se ve en 3D (la cocina, el horno, el bol, la masa, el pan, los ingredientes, los utensilios) está
**modelado en código**: geometría procedural y texturas dibujadas con `<canvas>`. Los sonidos también se generan
en el momento con la Web Audio API. No hay archivos de modelos, imágenes ni audio.

## Cómo abrirlo

El juego usa módulos de JavaScript, así que hay que abrirlo desde un servidor local (no con doble clic en el archivo):

```bash
npm start                       # o bien: npx serve .
# alternativa sin Node:
python3 -m http.server 8080
```

y abre <http://localhost:8080>. Necesita conexión a internet la primera vez para descargar Three.js y las fuentes.
También funciona tal cual en GitHub Pages (Settings → Pages → rama del proyecto).

## Cómo se juega

| Paso | Qué haces |
|---|---|
| 1. Ingredientes | Mantén pulsado un recipiente (o el botón «Verter») para echarlo en el bol. La báscula marca los gramos: suelta al llegar a la cantidad de la receta. |
| 2. Mezclar | Dibuja círculos sobre el bol con el ratón o el dedo (o mantén «Remover») hasta que no quede harina seca. |
| 3. Amasar | Arrastra la masa para estirarla y suelta para plegarla. Si se pega, enharina. La prueba de la ventana te dice si el gluten está listo. |
| 4. Fermentar | Tapa el bol, elige dónde reposa (encimera, junto al horno o nevera) y deja correr el tiempo. Haz la prueba del dedo y decide cuándo está lista. |
| 5. Formar | Desgasifica, elige la forma (hogaza, barra o molde), deja el segundo levado, dibuja los cortes con la cuchilla y elige cobertura. |
| 6. Hornear | Elige la temperatura y si quieres vapor, precalienta, mete el pan y vigila el color por el cristal. Tú decides cuándo sacarlo. |
| 7. Resultado | Puntuación por etapas con consejos. Corta el pan para ver la miga. |

Hay tres panes: **hogaza rústica**, **baguette** y **pan de molde**, cada uno con su receta, tiempos y temperatura.
El **modo guiado** muestra consejos y las zonas ideales en los medidores; sin él, juegas a ojo, como en casa.

La simulación es sencilla pero tiene base real: la fermentación depende de la levadura, la sal, el azúcar y la
temperatura; el horno tarda en calentarse y se enfría al abrir la puerta; la corteza se dora por reacción de
Maillard según la temperatura; el centro del pan tiene que pasar de ~93 °C para no quedar crudo.

## Estructura

```
index.html            página principal (pantalla de carga, contenedores de la escena y la interfaz)
css/styles.css        estilos de la interfaz (paneles, botones, medidores, diálogos)
js/main.js            arranque: crea el motor, la interfaz y los modelos
js/engine.js          renderizador, cámara, luces, bucle y puntero
js/game.js            estado de la partida y cambio de etapas
js/stages/*.js        una clase por etapa del juego
js/recipe.js          simulación y puntuación (sin 3D, con pruebas)
js/ui.js              interfaz (HUD)
js/audio.js           sonidos sintetizados
js/particles.js       harina, vapor, humo, migas, destellos
js/models/*.js        modelos 3D: cocina, horno, masa, ingredientes y utensilios
js/core/*.js          animaciones, utilidades y distribución de la cocina
tests/                pruebas de la simulación (npm test)
```

## Pruebas

```bash
npm test
```

Parámetros útiles para desarrollar: `index.html?stage=bake&bread=baguette` salta directamente a una etapa
(`ingredients`, `mix`, `knead`, `proof`, `shape`, `bake`, `result`) y `&guided=0` desactiva el modo guiado.
