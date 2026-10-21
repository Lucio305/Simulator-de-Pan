// Etapa 4 · Fermentar: la masa reposa tapada en el bol hasta doblar su volumen.
import { Stage } from './stage.js';
import { proofStep, initialProof } from '../recipe.js';

export class ProofStage extends Stage {
  async enter() {
    this.instruct('Deja fermentar la masa', 'Etapa en construcción.');
    this.ui.setControls([{ type: 'button', id: 'next', label: 'Continuar', variant: 'primary', onClick: async () => { await this.autoComplete(); this.complete(); } }]);
  }

  async autoComplete() {
    const { tools, dough } = this.models;
    const [lo, hi] = this.bread.proof1Ideal;
    const env = { amounts: this.state.amounts, tempC: 22 };
    let proof = initialProof(22);
    while (proof.p < (lo + hi) / 2 && proof.minutes < 600) proof = proofStep(proof, 1, env);
    this.state.proof1 = { ...proof, spot: 'encimera' };
    this.game.advanceClock(proof.minutes);
    tools.cloth.reset();
    this.placeAt(dough.group, tools.bowl.anchors.contents);
    dough.group.visible = true;
    dough.set({ shape: 'ball', rise: proof.rise, collapse: proof.collapse, squash: 0, stretch: 0 });
  }
}
