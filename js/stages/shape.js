// Etapa 5 · Formar: desgasificar, dar forma, segundo levado, greñar y cobertura.
import { Stage, scorePattern } from './stage.js';
import { proofStep, initialProof } from '../recipe.js';

export class ShapeStage extends Stage {
  async enter() {
    this.instruct('Da forma al pan', 'Etapa en construcción.');
    this.ui.setControls([{ type: 'button', id: 'next', label: 'Continuar', variant: 'primary', onClick: async () => { await this.autoComplete(); this.complete(); } }]);
  }

  async autoComplete() {
    const { tools, dough } = this.models;
    const bread = this.bread;
    const shape = bread.shape;
    const topping = bread.toppings?.suggested ?? 'none';
    const [lo, hi] = bread.proof2Ideal;
    const env = { amounts: this.state.amounts, tempC: 24 };
    let proof = initialProof(24);
    while (proof.p < (lo + hi) / 2 && proof.minutes < 600) proof = proofStep(proof, 1, env);
    this.state.proof2 = proof;
    this.game.advanceClock(proof.minutes);

    if (shape === 'loaf') {
      tools.tray.hide();
      tools.tin.show();
      this.placeAt(dough.group, tools.tin.anchors.inside);
    } else {
      tools.tin.hide();
      tools.tray.show();
      tools.tray.setParchment(true);
      this.placeAt(dough.group, tools.tray.anchors.top);
    }
    dough.group.visible = true;
    dough.clearScores();
    dough.set({ shape, inTin: shape === 'loaf', rise: proof.rise, collapse: proof.collapse, smoothness: Math.max(0.85, this.state.knead.gluten), flour: 0, squash: 0, stretch: 0 });
    const cuts = shape === 'loaf' ? [] : scorePattern(shape === 'baguette' ? 'diagonals' : 'cross', shape);
    for (const c of cuts) dough.addScore(c);
    dough.setTopping(topping);
    tools.lame.reset();
    this.state.shape = { shape, scores: cuts.length, topping };
  }
}
