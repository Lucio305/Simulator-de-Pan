// Etapa 6 · Hornear: precalentar, meter el pan, vigilar el color y sacarlo a tiempo.
import { Stage } from './stage.js';
import { bakeStep, initialBake, idealBakeWindow } from '../recipe.js';

export class BakeStage extends Stage {
  async enter() {
    this.instruct('Hornea el pan', 'Etapa en construcción.');
    this.ui.setControls([{ type: 'button', id: 'next', label: 'Continuar', variant: 'primary', onClick: async () => { await this.autoComplete(); this.complete(); } }]);
  }

  async autoComplete() {
    const { oven, dough, kitchen } = this.models;
    const bread = this.bread;
    const targetC = bread.bake.tempC;
    const steam = bread.bake.steam !== 'no';
    Object.assign(this.state.bake, { targetC, steam, preheated: true, doorOpenings: 0 });
    const window = idealBakeWindow(bread.id, { ovenC: targetC, steam });
    const minutes = window.minutes ? (window.minutes[0] + window.minutes[1]) / 2 : bread.bake.minutes[0];
    let bake = initialBake(24);
    const opts = this.bakeOpts(targetC);
    for (let t = 0; t < minutes; t += 0.5) bake = bakeStep(bake, 0.5, opts);
    Object.assign(this.state.bake, bake);
    this.state.oven = { tempC: targetC, targetC, on: false, doorOpen: false };
    this.game.advanceClock(12 + minutes);
    oven.reset();
    oven.setTemperature(targetC);
    oven.setTargetTemperature(targetC);
    kitchen.setOvenGlow(0);
    dough.set({ bake: bake.crust, rise: this.state.proof2.rise * bake.spring });
  }
}
