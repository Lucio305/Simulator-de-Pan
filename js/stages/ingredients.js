// Etapa 1 · Ingredientes: pesar cada ingrediente vertiéndolo en el bol sobre la báscula.
import { Stage, totalGrams } from './stage.js';

export class IngredientsStage extends Stage {
  async enter() {
    this.instruct('Pesa los ingredientes', 'Etapa en construcción.');
    this.ui.setControls([{ type: 'button', id: 'next', label: 'Continuar', variant: 'primary', onClick: async () => { await this.autoComplete(); this.complete(); } }]);
  }

  async autoComplete() {
    const { ingredients, tools } = this.models;
    Object.assign(this.state.amounts, this.bread.recipe);
    ingredients.bowlContents.setVisible(true);
    ingredients.bowlContents.setMix(0);
    ingredients.bowlContents.setAmounts(this.state.amounts);
    tools.scale.setReading(totalGrams(this.state.amounts));
  }
}
