// Extracted from jingyu engine.mjs; MIT, InariNGT-Ofiicial, 2026.
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const smooth=t=>t*t*(3-2*t);
export function samplePoints(points,t){
  if(t<=points[0][0])return points[0][1];
  for(let i=1;i<points.length;i++)if(t<=points[i][0]){
    const [a,x]=points[i-1],[b,y]=points[i];return x+(y-x)*smooth(clamp((t-a)/Math.max(1e-8,b-a),0,1));
  }
  return points.at(-1)[1];
}
function bez(a,b,c,d,t){return (1-t)**3*a+3*(1-t)**2*t*b+3*(1-t)*t*t*c+t**3*d;}
export function sampleMotion(s,t){
  let prev=[s[0],s[1]],i=2;
  while(i<s.length){
    const kind=s[i++];let end,c1,c2;
    if(kind===1){c1=s.slice(i,i+2);c2=s.slice(i+2,i+4);end=s.slice(i+4,i+6);i+=6;}
    else{end=s.slice(i,i+2);i+=2;}
    if(t<=end[0]){
      if(kind===0)return prev[1]+(end[1]-prev[1])*clamp((t-prev[0])/Math.max(1e-8,end[0]-prev[0]),0,1);
      if(kind===2)return prev[1];if(kind===3)return end[1];
      let lo=0,hi=1;for(let k=0;k<15;k++){const u=(lo+hi)/2;if(bez(prev[0],c1[0],c2[0],end[0],u)<t)lo=u;else hi=u;}
      return bez(prev[1],c1[1],c2[1],end[1],(lo+hi)/2);
    }prev=end;
  }return prev[1];
}
