// Etapa 7 · Resultado: el pan sale a la rejilla, se puntúa y se puede cortar para ver la miga.
import { Stage } from './stage.js';
import { evaluate } from '../recipe.js';

export class ResultStage extends Stage {
  async enter() {
    const { tools, dough } = this.models;
    tools.coolingRack.show();
    tools.tray.hide();
    tools.tin.hide();
    this.placeAt(dough.group, tools.coolingRack.anchors.top);
    dough.set({ inTin: false });
    this.state.result = evaluate(this.state);
    this.instruct('¡Pan horneado!', 'Etapa en construcción.');
    const best = this.game.saveBest(this.state.breadId, this.state.result.total);
    const choice = await this.ui.showResult({ ...this.state.result, best });
    if (choice === 'again') this.game.restart();
  }
}
