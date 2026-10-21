// Etapa 3 · Amasar: estirar y plegar la masa sobre la tabla enharinada hasta desarrollar el gluten.
import { Stage } from './stage.js';

export class KneadStage extends Stage {
  async enter() {
    this.instruct('Amasa hasta que esté lisa', 'Etapa en construcción.');
    this.ui.setControls([{ type: 'button', id: 'next', label: 'Continuar', variant: 'primary', onClick: async () => { await this.autoComplete(); this.complete(); } }]);
  }

  async autoComplete() {
    const { tools, dough } = this.models;
    Object.assign(this.state.knead, { gluten: 0.93, strokes: 32, extraFlour: 10, windowpane: true });
    tools.board.setFlour(0.6);
    this.placeAt(dough.group, tools.board.anchors.top);
    dough.group.scale.setScalar(1);
    dough.group.visible = true;
    dough.set({ shape: 'ball', mix: 1, smoothness: 0.93, hydration: this.hydration, flour: 0.15, rise: 1, squash: 0, stretch: 0 });
  }
}
