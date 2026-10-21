// Etapa 2 · Mezclar: remover en el bol hasta que los ingredientes formen una masa.
import { Stage } from './stage.js';

export class MixStage extends Stage {
  async enter() {
    this.instruct('Mezcla los ingredientes', 'Etapa en construcción.');
    this.ui.setControls([{ type: 'button', id: 'next', label: 'Continuar', variant: 'primary', onClick: async () => { await this.autoComplete(); this.complete(); } }]);
  }

  async autoComplete() {
    const { ingredients, tools, dough } = this.models;
    this.state.mix = 1;
    ingredients.bowlContents.setMix(1);
    ingredients.bowlContents.setVisible(false);
    tools.spoon.reset();
    this.placeAt(dough.group, tools.bowl.anchors.contents);
    dough.group.scale.setScalar(1);
    dough.group.visible = true;
    dough.set({ shape: 'ball', mix: 1, smoothness: 0.1, hydration: this.hydration, flour: 0.25, rise: 1, collapse: 0, squash: 0, stretch: 0 });
  }
}
