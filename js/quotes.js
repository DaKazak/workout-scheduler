/* Motivational quotes. Only well-documented attributions are named; anything doubtful is left unattributed (author: null). */
(function (root) {
  'use strict';
  var QUOTES = [
    { text: 'Life is like riding a bicycle. To keep your balance, you must keep moving.', author: 'Albert Einstein' },
    { text: 'It never gets easier, you just go faster.', author: 'Greg LeMond' },
    { text: 'If you want to run, run a mile. If you want to experience a different life, run a marathon.', author: 'Emil Zátopek' },
    { text: 'The miracle isn\u2019t that I finished. The miracle is that I had the courage to start.', author: 'John Bingham' },
    { text: 'I have two doctors, my left leg and my right.', author: 'G. M. Trevelyan' },
    { text: 'Methinks that the moment my legs begin to move, my thoughts begin to flow.', author: 'Henry David Thoreau' },
    { text: 'Strength does not come from physical capacity. It comes from an indomitable will.', author: 'Mahatma Gandhi' },
    { text: 'We are what we repeatedly do. Excellence, then, is not an act, but a habit.', author: 'Will Durant' },
    { text: 'Run when you can, walk if you have to, crawl if you must; just never give up.', author: 'Dean Karnazes' },
    { text: 'You miss 100% of the shots you don\u2019t take.', author: 'Wayne Gretzky' },
    { text: 'Hard work beats talent when talent doesn\u2019t work hard.', author: 'Tim Notke' },
    { text: 'Champions keep playing until they get it right.', author: 'Billie Jean King' },
    { text: 'Age is no barrier. It\u2019s a limitation you put on your mind.', author: 'Jackie Joyner-Kersee' },
    { text: 'I\u2019ve failed over and over and over again in my life. And that is why I succeed.', author: 'Michael Jordan' },
    { text: 'Take care of your body. It\u2019s the only place you have to live.', author: 'Jim Rohn' },
    { text: 'Exercise is king. Nutrition is queen. Put them together and you\u2019ve got a kingdom.', author: 'Jack LaLanne' },
    { text: 'Motivation is what gets you started. Habit is what keeps you going.', author: 'Jim Ryun' },
    { text: 'To give anything less than your best is to sacrifice the gift.', author: 'Steve Prefontaine' },
    { text: 'Somewhere in the world someone is training when you are not. When you race him, he will win.', author: 'Tom Fleming' },
    { text: 'Everything you\u2019ve ever wanted is on the other side of fear.', author: 'George Addair' },
    { text: 'It is not the mountain we conquer, but ourselves.', author: 'Edmund Hillary' },
    { text: 'Walk as if you are kissing the Earth with your feet.', author: 'Thich Nhat Hanh' },
    { text: 'Shut up, legs!', author: 'Jens Voigt' },
    { text: 'I hated every minute of training, but I said, \u201CDon\u2019t quit. Suffer now and live the rest of your life as a champion.\u201D', author: 'Muhammad Ali' },
    { text: 'Pain is temporary. Quitting lasts forever.', author: 'Lance Armstrong' },
    { text: 'The difference between the impossible and the possible lies in a person\u2019s determination.', author: 'Tommy Lasorda' },
    { text: 'Ride as much or as little, or as long or as short as you feel. But ride.', author: 'Eddy Merckx' },
    { text: 'The only bad workout is the one that didn\u2019t happen.', author: null },
    { text: 'It does not matter how slowly you go as long as you do not stop.', author: null },
    { text: 'No matter how slow you go, you are still lapping everybody on the couch.', author: null },
    { text: 'The body achieves what the mind believes.', author: null },
    { text: 'Don\u2019t count the days, make the days count.', author: null },
    { text: 'Do something today that your future self will thank you for.', author: null },
    { text: 'Sore today, strong tomorrow.', author: null },
    { text: 'One run can change your day. Many runs can change your life.', author: null },
    { text: 'Small steps every day add up to big results.', author: null }
  ];
  if (typeof module !== 'undefined' && module.exports) module.exports = QUOTES;
  else root.WORKOUT_QUOTES = QUOTES;
})(this);
