import React from 'react';

/**
 * Hai viên xúc xắc 3D "lăn lóc" trên bàn khi đang gieo.
 *
 * - Khi `isRolling` = true: mỗi viên bị tung từ mép bàn vào, nảy vài lần, xoay nhiều vòng quanh 2 trục
 *   rồi dừng lại đúng mặt của kết quả. Animation kéo dài DICE_ROLL_MS (xem biến --dice-ms trong index.css).
 * - Kết quả chỉ "lộ" ra khi viên xúc xắc dừng hẳn (cuối animation). Mặt trên cùng lúc lăn liên tục thay đổi.
 * - Khi `isRolling` = false: viên xúc xắc nằm yên ở đúng mặt `die1` / `die2`.
 *
 * CSS nằm trong src/index.css (các class dice-*).
 */

export const DICE_ROLL_MS = 3300; // phải nhỏ hơn thời gian host giữ trạng thái isRolling (3500ms)

const DOTS: Record<number, [number, number][]> = {
  1: [[50, 50]],
  2: [[27, 27], [73, 73]],
  3: [[27, 27], [50, 50], [73, 73]],
  4: [[27, 27], [27, 73], [73, 27], [73, 73]],
  5: [[27, 27], [27, 73], [50, 50], [73, 27], [73, 73]],
  6: [[27, 27], [27, 50], [27, 73], [73, 27], [73, 50], [73, 73]],
};

// Góc xoay của khối lập phương để mặt `value` hướng về người xem.
// Các mặt đối nhau cộng lại bằng 7: 1-6, 3-4, 2-5.
const ORIENTATION: Record<number, { fx: number; fy: number }> = {
  1: { fx: 0, fy: 0 },
  6: { fx: 0, fy: 180 },
  3: { fx: 0, fy: -90 },
  4: { fx: 0, fy: 90 },
  2: { fx: -90, fy: 0 },
  5: { fx: 90, fy: 0 },
};

const FACE_VALUES = [1, 2, 3, 4, 5, 6];

const Die: React.FC<{ value: number; isRolling: boolean; index: 1 | 2 }> = ({ value, isRolling, index }) => {
  const safe = value >= 1 && value <= 6 ? value : 1;
  const { fx, fy } = ORIENTATION[safe];
  const style = { '--fx': `${fx}deg`, '--fy': `${fy}deg` } as React.CSSProperties;

  return (
    <div className={`dice-slot dice-n-${index}${isRolling ? ' dice-rolling' : ''}`}>
      <div className="dice-travel">
        <div className="dice-shadow" />
        <div className="dice-hop">
          <div className="dice-cube" style={style}>
            {FACE_VALUES.map((face) => (
              <div key={face} className={`dice-face dice-face-${face}`}>
                <svg viewBox="0 0 100 100" className="w-full h-full">
                  {DOTS[face].map(([cx, cy], i) => (
                    <circle key={i} cx={cx} cy={cy} r="11" fill={face === 1 ? '#dc2626' : '#0f172a'} />
                  ))}
                </svg>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

export const DicePair: React.FC<{ die1: number; die2: number; isRolling: boolean }> = ({ die1, die2, isRolling }) => (
  <div className="dice-pair" style={{ '--dice-ms': `${DICE_ROLL_MS}ms` } as React.CSSProperties}>
    <Die value={die1} isRolling={isRolling} index={1} />
    <Die value={die2} isRolling={isRolling} index={2} />
  </div>
);
