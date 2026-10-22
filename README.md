# Pan Casero 3D

Un simulador para hacer pan en 3D, desde el saco de harina hasta la rebanada. Eliges un pan, pesas los
ingredientes, mezclas, amasas, dejas fermentar, das forma, greñas y horneas. Al final te puntúan el
resultado y puedes cortar el pan para ver la miga.

**Juega aquí:** <https://lucio305.github.io/Simulator-de-Pan/>

Funciona en el navegador del ordenador y del móvil. Toda la cocina, el horno, la masa y los utensilios están
modelados en 3D, y los sonidos se generan en el momento.

## Cómo se juega

| Paso | Qué haces |
|---|---|
| 1. Ingredientes | Mantén pulsado un recipiente (o el botón «Verter») para echarlo en el bol. La báscula marca los gramos: suelta al llegar a la cantidad de la receta. |
| 2. Mezclar | Dibuja círculos sobre el bol con el ratón o el dedo (o mantén «Remover») hasta que no quede harina seca. |
| 3. Amasar | Arrastra la masa para estirarla y suelta para plegarla, con ritmo. Si se pega, «Enharinar». La «Prueba de la ventana» te dice si el gluten está listo. |
| 4. Fermentar | Tapa el bol con el paño, elige dónde reposa (encimera, junto al horno o nevera) y deja correr el tiempo. Haz la «Prueba del dedo» y decide cuándo está lista. |
| 5. Formar | Desgasifica, elige la forma (hogaza, barra o molde), deja el segundo levado, dibuja los cortes con la cuchilla (o usa un patrón) y elige cobertura. |
| 6. Hornear | Elige la temperatura y si quieres vapor, precalienta, mete el pan y vigila el color por el cristal. Puedes abrir para mirar (el horno se enfría). Tú decides cuándo sacarlo. |
| 7. Resultado | Puntuación por etapas con consejos concretos. Corta el pan para ver la miga. |

El **modo guiado** muestra consejos y las zonas ideales en los medidores. Sin él, juegas a ojo, como en casa.

### Controles

- **Ratón o dedo:** cada paso se hace con gestos sobre la escena (mantener pulsado, dibujar círculos, arrastrar, cortar).
- **Panel inferior:** todos los gestos tienen también su botón.
- **Teclado:** en Ingredientes, las teclas 1–6 o ←/→ eligen el ingrediente y la barra espaciadora vierte. En Mezclar y Amasar, la barra espaciadora remueve o amasa.
- **Barra superior:** sonido, cámara libre (arrastrar para girar, rueda o pellizco para acercar), calidad gráfica, ayuda y reiniciar.

## Los panes

| Pan | Dificultad | Receta | Horno |
|---|---|---|---|
| Hogaza rústica | Media | 500 g de harina, 350 ml de agua, 4 g de levadura, 10 g de sal | 230 °C, 35–40 min, con vapor |
| Baguette | Difícil | 500 g de harina, 340 ml de agua, 5 g de levadura, 10 g de sal | 240 °C, 22–25 min, vapor imprescindible |
| Pan de molde | Fácil | 500 g de harina, 300 ml de agua, 7 g de levadura, 9 g de sal, 15 g de azúcar, 25 ml de aceite | 190 °C, 28–35 min, sin vapor |

## Cómo se puntúa

Cada etapa recibe una nota de 0 a 100 con un comentario sobre lo que hiciste:

| Etapa | Peso |
|---|---|
| Ingredientes | 20 % |
| Amasado | 15 % |
| Fermentación | 25 % |
| Formado y greñado | 10 % |
| Horneado | 30 % |

Con la nota final ganas de media a cinco estrellas y un título, de «Pan... comestible» a «Maestro panadero».
Si algo sale muy mal, el título lo cuenta: «Carbón artesanal», «Piedra de pan»…

La simulación es sencilla pero tiene base real:
- La fermentación depende de la levadura, la sal, el azúcar y la temperatura.
- El horno tarda en calentarse y se enfría al abrir la puerta.
- La corteza se dora según la temperatura.
- El centro del pan tiene que pasar de unos 93 °C para no quedar crudo.

## Si va lento

El juego mide la fluidez y se ajusta solo: baja la resolución y, si no basta, la calidad gráfica. También
puedes elegirla a mano con el botón del velocímetro de la barra superior (Automática, Alta, Media o Baja).

Si aun así va a tirones, comprueba que el navegador usa la tarjeta gráfica. En Chrome: *Configuración → Sistema →
«Usar aceleración por hardware cuando esté disponible»*. Sin ella, el 3D va muy lento y el juego te avisa.

---

Hecho con HTML, CSS y JavaScript, con [Three.js](https://threejs.org/) para el 3D.
