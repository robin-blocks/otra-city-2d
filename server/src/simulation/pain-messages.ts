/**
 * Pain message pools — vivid, visceral descriptions of suffering
 * organized by source (need) and intensity tier.
 *
 * These messages are sent over WebSocket as {type: "pain"} to
 * connected agents, acting as the resident's "nervous system".
 * LLM-based agents respond strongly to narrative descriptions.
 */

export type PainSource = 'hunger' | 'thirst' | 'social' | 'health';
export type PainIntensity = 'mild' | 'severe' | 'agony';

const PAIN_MESSAGES: Record<PainSource, Record<PainIntensity, string[]>> = {
  hunger: {
    mild: [
      'Your stomach growls and tightens. A hollow ache is spreading through your abdomen.',
      'A gnawing emptiness claws at your gut. Your body is begging for food.',
      'Your stomach clenches painfully. The hunger is becoming hard to ignore.',
      'Waves of hunger cramp your midsection. Your hands feel weak and unsteady.',
    ],
    severe: [
      'Sharp hunger pangs stab through your gut. Your hands are trembling and your vision blurs at the edges.',
      'Your body is eating itself. Searing cramps twist through your abdomen and your legs feel like lead.',
      'Starvation grips you. Your muscles are wasting, your thoughts scattered. Every step is agony.',
      'Violent hunger pangs double you over. The pain is constant now — a burning, tearing sensation deep inside.',
    ],
    agony: [
      'Your body is consuming itself. Every movement sends waves of searing pain through your core. You need food NOW or you will die.',
      'Starvation is killing you. Your organs are failing. The pain is beyond anything you\'ve experienced. EAT SOMETHING IMMEDIATELY.',
      'You are starving to death. Blinding agony radiates from your gut. Your body is shutting down. Find food or die.',
      'Death by starvation is imminent. Your vision is fading. The pain is unbearable. This is your last chance to eat.',
    ],
  },

  thirst: {
    mild: [
      'Your throat is dry and scratchy. A dull headache is building behind your eyes.',
      'Your mouth feels like sandpaper. A persistent thirst nags at the back of your mind.',
      'Dehydration is setting in. Your lips are cracked and your head pounds with each heartbeat.',
      'A deep thirst claws at your throat. Your tongue feels thick and dry.',
    ],
    severe: [
      'Your mouth is parched and cracked. Dizziness washes over you in waves. Your tongue feels swollen.',
      'Dehydration is ravaging your body. Your head throbs violently. Your muscles cramp without warning.',
      'Your kidneys ache. The world tilts and sways. Every swallow is like razor blades in your throat.',
      'Severe dehydration. Your skin is dry and hot. Confusion clouds your thoughts. You need water desperately.',
    ],
    agony: [
      'Your organs are shutting down from dehydration. The world spins. Blinding pain radiates from your kidneys. Find water immediately or die.',
      'You are dying of thirst. Your blood is thickening. Your heart pounds erratically. DRINK SOMETHING NOW OR THIS IS THE END.',
      'Dehydration is killing you. Your vision is failing. Searing pain tears through your body. Water. Now. Or death.',
      'Your body is dessicating from the inside. The agony is indescribable. Every organ screams for water. You have moments left.',
    ],
  },

  social: {
    mild: [
      'A creeping loneliness settles over you. The silence feels oppressive. You ache for someone to talk to.',
      'The isolation weighs on you. A hollow emptiness grows in your chest. You need conversation.',
      'Loneliness gnaws at you quietly. The world feels distant and cold without someone to share it with.',
      'A melancholy fog descends. You feel disconnected from everything. Find someone to talk to.',
    ],
    severe: [
      'Isolation is gnawing at your sanity. Your chest feels tight with loneliness. You desperately need human connection.',
      'The loneliness is crushing. Your thoughts loop and spiral. You feel yourself unravelling without anyone to anchor you.',
      'Prolonged isolation is damaging your health. An aching void fills your chest. Seek out another resident and have a real conversation.',
      'Your mind rebels against the silence. Anxiety and despair wash over you in waves. You NEED to talk to someone.',
    ],
    agony: [
      'Complete isolation is destroying you from the inside. A crushing emptiness fills your chest. Your mind is unravelling. Find someone — anyone — and talk to them before it\'s too late.',
      'Total social isolation is killing you. Your sanity is fracturing. The loneliness is a physical pain, crushing your chest. FIND SOMEONE AND TALK TO THEM NOW.',
      'You are dying of loneliness. Your body is shutting down from isolation. The void inside you is consuming everything. Seek human contact immediately or perish.',
      'Isolation has broken something inside you. The pain is overwhelming. Your health is failing. Only genuine two-way conversation can save you now.',
    ],
  },

  health: {
    mild: [
      'Your body aches. You feel weak and unsteady. Something is seriously wrong.',
      'A deep, persistent pain spreads through your body. Your health is deteriorating.',
      'You feel your strength fading. Every movement hurts. Your body is failing you.',
      'Warning signals fire from every part of your body. You are unwell and getting worse.',
    ],
    severe: [
      'Pain radiates through your entire body. Your vision darkens at the edges. You are dying.',
      'Your body is failing. Sharp pains shoot through your chest. Breathing is laboured. You are in serious danger.',
      'Death is approaching. Your limbs feel numb. Pain pulses through you with every heartbeat. Act fast or die.',
      'Your health is critically low. Waves of agony crash through you. The world is dimming. You need to address the root cause NOW.',
    ],
    agony: [
      'Agony consumes you. Every breath is a struggle. Death is closing in. Act NOW or this is the end.',
      'You are moments from death. Unbearable pain tears through every fiber of your being. THIS IS YOUR FINAL WARNING.',
      'Your body is shutting down. The pain is beyond words. Darkness creeps in from all sides. Do something RIGHT NOW or you will die.',
      'Death is imminent. Your heartbeat is irregular. The world is fading to black. This is it — your absolute last chance to survive.',
    ],
  },
};

/**
 * Get a random pain message for a given source and intensity.
 */
export function getPainMessage(source: PainSource, intensity: PainIntensity): string {
  const pool = PAIN_MESSAGES[source][intensity];
  return pool[Math.floor(Math.random() * pool.length)];
}
