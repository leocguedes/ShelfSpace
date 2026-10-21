export type Unit='unidades'|'pacotes'|'latas'|'garrafas'|'sacos'|'caixas'|'potes'|'bandejas'|'kg'|'g'|'L'|'ml';

export const units:Unit[]=['unidades','pacotes','latas','garrafas','sacos','caixas','potes','bandejas','kg','g','L','ml'];

export const searchKey=(value:string)=>value.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();

export const unitLabel=(unit:Unit,language:'pt-BR'|'en'='pt-BR',quantity=2)=>{
  const labels:Record<Unit,{pt:string;en:string;ptPlural?:string;enPlural?:string}>={
    unidades:{pt:'unidade',ptPlural:'unidades',en:'unit',enPlural:'units'},
    pacotes:{pt:'pacote',ptPlural:'pacotes',en:'package',enPlural:'packages'},
    latas:{pt:'lata',ptPlural:'latas',en:'can',enPlural:'cans'},
    garrafas:{pt:'garrafa',ptPlural:'garrafas',en:'bottle',enPlural:'bottles'},
    sacos:{pt:'saco',ptPlural:'sacos',en:'bag',enPlural:'bags'},
    caixas:{pt:'caixa',ptPlural:'caixas',en:'box',enPlural:'boxes'},
    potes:{pt:'pote',ptPlural:'potes',en:'container',enPlural:'containers'},
    bandejas:{pt:'bandeja',ptPlural:'bandejas',en:'tray',enPlural:'trays'},
    kg:{pt:'kg',en:'kg'},g:{pt:'g',en:'g'},L:{pt:'L',en:'L'},ml:{pt:'mL',en:'mL'}
  };
  const label=labels[unit];
  const singular=quantity===1;
  if(language==='en')return singular?label.en:(label.enPlural||label.en);
  return singular?label.pt:(label.ptPlural||label.pt);
};

export const formatQuantity=(quantity:number,unit:Unit,language:'pt-BR'|'en'='pt-BR')=>quantity+' '+unitLabel(unit,language,quantity);

export const quantityStep=(unit:Unit)=>unit==='kg'||unit==='L'?0.1:1;
